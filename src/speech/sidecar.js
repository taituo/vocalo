// Bridge to the Python speech sidecar (mic + VAD + turn detection + STT + TTS + playback).
// The sidecar owns all audio so the hot path (mic -> VAD -> STT, TTS -> speaker)
// never crosses a process boundary as raw audio. Node only sees text + events.
//
// sidecar -> node events:
//   ready {engines}, vad {speaking}, partial {text}, final {text, lang, sttMs, endOfSpeechAt}
//   say_start {id, text, durationMs}  (emitted when that chunk STARTS PLAYING -> subtitle sync)
//   say_end {id}, idle {}  (playback queue drained), barge_in {}, error {message}, log {message}
// node -> sidecar commands:
//   say {id, text, lang}, stop {}, mic {enabled}, mode {mode:'vad'|'ptt'}, ptt {active}
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

export class SpeechSidecar extends EventEmitter {
  constructor({ url = 'ws://127.0.0.1:8765', spawnCmd = null, cwd } = {}) {
    super();
    this.url = url;
    this.spawnCmd = spawnCmd;
    this.cwd = cwd;
    this.ws = null;
    this.queue = [];
  }

  async start({ retries = 120, delayMs = 500 } = {}) {
    if (this.spawnCmd) {
      const [cmd, ...args] = this.spawnCmd;
      this.proc = spawn(cmd, args, { cwd: this.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
      this.proc.stdout.on('data', (d) => this.emit('log', { message: d.toString().trim() }));
      this.proc.stderr.on('data', (d) => this.emit('log', { message: d.toString().trim() }));
      this.proc.on('exit', (c) => this.emit('error', { message: `speech sidecar exited (${c})` }));
    }
    for (let i = 0; i < retries; i++) {
      try { await this.#connect(); return this; } catch { await new Promise((r) => setTimeout(r, delayMs)); }
    }
    throw new Error(`could not reach speech sidecar at ${this.url}`);
  }

  #connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.onopen = () => {
        this.ws = ws;
        for (const m of this.queue.splice(0)) ws.send(m);
        resolve();
      };
      ws.onerror = (e) => { if (!this.ws) reject(e); };
      ws.onclose = () => { if (this.ws === ws) { this.ws = null; this.emit('error', { message: 'sidecar connection closed' }); } };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
        this.emit(msg.type, msg);
        this.emit('any', msg);
      };
    });
  }

  send(obj) {
    const s = JSON.stringify(obj);
    if (this.ws?.readyState === 1) this.ws.send(s); else this.queue.push(s);
  }

  say(id, text, lang) { this.send({ type: 'say', id, text, lang }); }
  stop() { this.send({ type: 'stop' }); }
  mic(enabled) { this.send({ type: 'mic', enabled }); }
  mode(mode) { this.send({ type: 'mode', mode }); }
  ptt(active) { this.send({ type: 'ptt', active }); }

  close() {
    try { this.ws?.close(); } catch {}
    try { this.proc?.kill('SIGTERM'); } catch {}
  }
}

/** Text-only stand-in used with --no-speech: "speaks" by timing, so subtitles still flow. */
export class SilentSpeech extends EventEmitter {
  constructor({ wpm = 190 } = {}) { super(); this.wpm = wpm; this.q = []; this.playing = false; this.timer = null; }
  async start() { setTimeout(() => this.emit('ready', { engines: { tts: 'silent', stt: 'keyboard' } })); return this; }
  say(id, text) { this.q.push({ id, text }); if (!this.playing) this.#next(); }
  #next() {
    const item = this.q.shift();
    if (!item) { this.playing = false; this.emit('idle', {}); return; }
    this.playing = true;
    const durationMs = Math.max(400, (item.text.split(/\s+/).length / this.wpm) * 60000);
    this.emit('say_start', { id: item.id, text: item.text, durationMs });
    this.timer = setTimeout(() => { this.emit('say_end', { id: item.id }); this.#next(); }, durationMs);
  }
  stop() { clearTimeout(this.timer); this.q = []; if (this.playing) { this.playing = false; this.emit('idle', {}); } }
  mic() {} mode() {} ptt() {} close() { this.stop(); }
}
