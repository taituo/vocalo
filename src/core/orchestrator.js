// The conversation conductor: user speech -> ACP agent -> streamed TTS, with
// barge-in, subtitle sync, stage directions and latency metrics.
import { EventEmitter } from 'node:events';
import { SpeechChunker } from './chunker.js';
import { SceneParser } from './scene.js';
import { guessLang } from './lang.js';
import { VOICE_PREAMBLE } from './voice-preamble.js';

export const State = Object.freeze({ IDLE: 'idle', LISTENING: 'listening', THINKING: 'thinking', SPEAKING: 'speaking' });

export class Orchestrator extends EventEmitter {
  constructor({ acp, speech, config = {} }) {
    super();
    this.acp = acp;
    this.speech = speech;
    this.config = {
      bargeIn: true, permissions: 'ask', preamble: true, defaultLang: 'en', fillerAfterMs: 1400,
      // What to do when the user talks while the agent is busy doing agentic work (tools running):
      //   steer     -> inject into the running turn via Kiro _session/steer (falls back to interrupt)
      //   interrupt -> cancel and start a new turn
      //   queue     -> hold it and send when the turn finishes
      busyPolicy: 'steer',
      ...config,
    };
    this.intercept = null;     // (text, ctx) => boolean|Promise<boolean>: local commands handled before the agent
    this.queued = [];
    this.sysSeq = 0;
    this.cachedPhrases = new Set();
    this.state = State.IDLE;
    this.turn = null;          // active turn object
    this.turnSeq = 0;
    this.sayIds = new Set();   // chunks of the active turn still queued/playing
    this.lastLang = this.config.defaultLang;
    this.preambleSent = !this.config.preamble;
    this.pendingPermission = null;

    acp.on('update', (p) => this.#onUpdate(p));
    acp.onPermission = (req) => this.#onPermission(req);

    speech.on('vad', (m) => this.#onVad(m));
    speech.on('partial', (m) => this.emit('user_partial', m.text));
    speech.on('final', (m) => this.userSaid(m.text, m));
    speech.on('barge_in', () => this.#onBargeIn());
    speech.on('say_start', (m) => this.#onSayStart(m));
    speech.on('say_end', (m) => { this.sayIds.delete(m.id); this.#maybeFinish(); });
    speech.on('idle', () => this.#onSpeechIdle());
    speech.on('ready', (m) => { for (const k of m.cached ?? []) this.cachedPhrases.add(k); });
  }

  #setState(s) {
    if (this.state === s) return;
    this.state = s;
    this.emit('state', s);
  }

  // ---------- user side ----------
  #onVad({ speaking }) {
    if (speaking) {
      if (this.state === State.SPEAKING && this.config.bargeIn) this.#onBargeIn();
      if (this.state === State.IDLE) this.#setState(State.LISTENING);
    } else if (this.state === State.LISTENING && !this.turn) {
      // stay in listening until final arrives; sidecar sends final right after
    }
  }

  get #agentBusy() { return !!(this.turn && !this.turn.cancelled && !this.turn.ended && this.turn.activeTools?.size); }

  // User started talking over Vocalo. Audio stops at once (the sidecar already cut it).
  // During tool work we only go quiet: the final transcript decides steer vs interrupt,
  // so a cough doesn't kill a 5-minute refactor.
  #onBargeIn() {
    const turn = this.turn;
    this.speech.stop();
    this.sayIds.clear();
    if (!turn) return;
    if (this.#agentBusy && this.config.busyPolicy !== 'interrupt') { turn.silenced = true; this.#setState(State.LISTENING); return; }
    this.interrupt('barge-in');
  }

  /** Entry point for a finished user utterance (from STT or typed text). */
  async userSaid(text, meta = {}) {
    text = (text || '').trim();
    if (!text) {
      if (this.turn?.silenced) { this.turn.silenced = false; this.#setState(State.THINKING); } // noise: keep going
      else if (!this.turn) this.#setState(State.IDLE);
      return;
    }
    this.lastLang = meta.lang || guessLang(text, this.lastLang);
    this.emit('user_final', text);
    if (this.pendingPermission && this.#answerPermissionByVoice(text)) return;
    if (this.intercept && await this.intercept(text, { busy: !!this.turn, state: this.state, meta })) return;
    if (this.#agentBusy) {
      const policy = this.config.busyPolicy;
      if (policy === 'queue') {
        this.queued.push(text);
        this.emit('queued', text);
        return;
      }
      if (policy === 'steer' && this.acp.supports?.('_session/steer')) {
        this.speech.stop(); // stop narration, keep the work going
        try {
          await this.acp.steer(text);
          this.turn.steers = (this.turn.steers || 0) + 1;
          this.turn.silenced = false;
          this.#setState(State.THINKING);
          this.emit('steered', text);
          return;
        } catch (err) {
          this.emit('warn', `steer failed (${err.message}); interrupting instead`);
        }
      }
    }
    if (this.turn) {
      // The user kept talking before Vocalo said anything: it's one thought, not two.
      const prev = this.turn;
      const unheard = !prev.metrics.firstAudioAt && !prev.toolUsed;
      await this.interrupt('new-utterance');
      if (unheard) text = `${prev.userText} ${text}`;
    }
    this.#startTurn(text, meta);
  }

  // ---------- agent side ----------
  #startTurn(text, meta) {
    const t0 = Date.now();
    const turn = {
      id: ++this.turnSeq,
      metrics: { endOfSpeechAt: meta.endOfSpeechAt ?? t0, sttMs: meta.sttMs ?? null, promptAt: t0, firstTokenAt: null, firstSayAt: null, firstAudioAt: null },
      chunk: 0,
      cancelled: false,
      text: '',
      userText: text,
      fillerSent: false,
    };
    turn.chunker = new SpeechChunker({
      onSpeak: (s) => this.#say(turn, s),
      onCode: (code) => this.emit('code', code),
    });
    turn.scene = new SceneParser({
      onText: (s) => { turn.text += s; turn.chunker.push(s); this.emit('assistant_stream', s); },
      onScene: (tag) => this.emit('scene', tag),
    });
    this.turn = turn;
    this.#setState(State.THINKING);
    turn.fillerTimer = setTimeout(() => this.#filler(turn, 'hmm'), this.config.fillerAfterMs);

    let promptText = text;
    if (!this.preambleSent) { promptText = VOICE_PREAMBLE + text; this.preambleSent = true; }

    turn.done = this.acp.prompt(promptText)
      .then((res) => this.#onTurnEnd(turn, res?.stopReason ?? 'end_turn'))
      .catch((err) => {
        if (!turn.cancelled) this.emit('warn', `agent: ${err.message}`);
        this.#onTurnEnd(turn, 'error');
      });
  }

  #onUpdate(params) {
    const turn = this.turn;
    const u = params?.update ?? params;
    if (u?.sessionUpdate === 'plan') { this.emit('plan', u.entries ?? []); return; }
    if (!turn || turn.cancelled) return; // late chunks after cancel are dropped
    switch (u?.sessionUpdate) {
      case 'agent_message_chunk': {
        const c = u.content;
        if (c?.type === 'text' && c.text) {
          if (!turn.metrics.firstTokenAt) { turn.metrics.firstTokenAt = Date.now(); this.emit('metrics', this.#metrics(turn)); }
          turn.scene.push(c.text);
        } else if (c?.type === 'image') {
          this.emit('scene', { kind: 'show', imageData: c.data, mimeType: c.mimeType });
        }
        break;
      }
      case 'agent_thought_chunk':
        this.emit('thought', u.content?.text ?? '');
        break;
      case 'tool_call':
        turn.toolUsed = true;
        if (!turn.metrics.firstSayAt) this.#filler(turn, 'check');
      // fallthrough
      case 'tool_call_update': {
        turn.activeTools ??= new Set();
        if (u.status === 'completed' || u.status === 'failed') turn.activeTools.delete(u.toolCallId);
        else if (u.sessionUpdate === 'tool_call' || u.status === 'in_progress' || u.status === 'pending') turn.activeTools.add(u.toolCallId);
        this.emit('tool', { id: u.toolCallId, title: u.title, kind: u.kind, status: u.status, locations: u.locations });
        for (const c of u.content ?? []) {
          if (c.type === 'diff') this.emit('diff', { path: c.path, oldText: c.oldText ?? '', newText: c.newText ?? '', toolCallId: u.toolCallId });
          else if (c.type === 'content' && c.content?.type === 'image') this.emit('scene', { kind: 'show', imageData: c.content.data, mimeType: c.content.mimeType });
        }
        break;
      }
      case 'plan':
        this.emit('plan', u.entries ?? []);
        break;
      default:
        break; // ignore unknown types per ACP/Kiro guidance
    }
  }

  /** Pre-rendered "hmm, one moment" when the agent is slow: zero TTS latency, once per turn. */
  #filler(turn, kind) {
    if (turn.cancelled || turn.ended || turn.fillerSent || turn.metrics.firstSayAt) return;
    if (kind === 'hmm' && turn.metrics.firstTokenAt) return; // words are already flowing
    const key = `${this.lastLang === 'fi' ? 'fi' : 'en'}.${kind}`;
    if (!this.cachedPhrases.has(key)) return;
    turn.fillerSent = true;
    clearTimeout(turn.fillerTimer);
    const text = { 'en.hmm': 'Hmm, let me think.', 'en.check': 'One moment, let me check.', 'fi.hmm': 'Hmm, hetkinen.', 'fi.check': 'Hetki, katson.' }[key];
    const id = `${turn.id}.f`;
    this.sayIds.add(id);
    this.speech.say(id, text, this.lastLang, key);
    this.emit('filler', key);
  }

  #say(turn, text) {
    if (turn.cancelled || turn.silenced) return;
    clearTimeout(turn.fillerTimer);
    const id = `${turn.id}.${++turn.chunk}`;
    const lang = guessLang(text, this.lastLang);
    if (!turn.metrics.firstSayAt) turn.metrics.firstSayAt = Date.now();
    turn.spoken = (turn.spoken || 0) + 1;
    this.sayIds.add(id);
    this.speech.say(id, text, lang);
  }

  #onSayStart({ id, text, durationMs }) {
    if (id?.startsWith('sys.')) { this.emit('assistant_subtitle', { text, durationMs }); return; }
    const turn = this.turn;
    if (!turn || !id?.startsWith(`${turn.id}.`)) return;
    if (id.endsWith('.f')) { turn.metrics.fillerAt ??= Date.now(); }
    else if (!turn.metrics.firstAudioAt) {
      turn.metrics.firstAudioAt = Date.now();
      this.emit('metrics', this.#metrics(turn));
    }
    this.#setState(State.SPEAKING);
    this.emit('assistant_subtitle', { text, durationMs });
  }

  #onTurnEnd(turn, stopReason) {
    clearTimeout(turn.fillerTimer);
    if (turn.cancelled) { turn.ended = true; return; } // interrupt() owns state from here
    if (this.turn !== turn) return;
    turn.scene.flush();
    turn.chunker.flush();
    turn.ended = true;
    this.emit('turn_end', { stopReason, text: turn.text });
    if (this.sayIds.size === 0) this.#finishTurn(turn);
  }

  // Only say_end shrinks sayIds; 'idle' can race with a just-sent say, so it never clears them.
  #onSpeechIdle() { this.#maybeFinish(); }

  #maybeFinish() {
    const turn = this.turn;
    if (!turn || this.sayIds.size) return;
    if (turn.ended) this.#finishTurn(turn);
    else this.#setState(State.THINKING); // agent still working (e.g. tool call)
  }

  #finishTurn(turn) {
    if (this.turn !== turn) return;
    this.turn = null;
    this.#setState(State.IDLE);
    if (this.queued.length) {
      const text = this.queued.splice(0).join(' ');
      setImmediate(() => this.#startTurn(text, {}));
    }
  }

  /** Stop talking and cancel the agent turn. Resolves once the old prompt settled. */
  async interrupt(reason = 'user') {
    const turn = this.turn;
    this.speech.stop();
    this.sayIds.clear();
    if (!turn) return;
    turn.cancelled = true;
    clearTimeout(turn.fillerTimer);
    this.cancelPermission(); // Kiro: cancel pending permissions before session/cancel
    this.queued = [];
    this.emit('interrupted', reason);
    if (!turn.ended) {
      this.acp.cancel();
      // Kiro: wait for the original session/prompt response before sending a new prompt.
      await Promise.race([turn.done, new Promise((r) => setTimeout(r, 2500))]);
    }
    if (this.turn === turn) this.turn = null;
    this.#setState(State.LISTENING);
  }

  /** Vocalo speaking for itself (command confirmations), outside any agent turn. */
  announce(text, lang = this.lastLang) {
    const id = `sys.${++this.sysSeq}`;
    this.speech.say(id, text, lang);
    this.emit('announce', text);
  }

  // ---------- permissions ----------
  async #onPermission(req) {
    const options = req.options ?? [];
    const pick = (kinds) => options.find((o) => kinds.includes(o.kind));
    if (this.config.permissions === 'allow') {
      const o = pick(['allow_once']) ?? pick(['allow_always']);
      return o ? { outcome: { outcome: 'selected', optionId: o.optionId } } : { outcome: { outcome: 'cancelled' } };
    }
    if (this.config.permissions === 'deny') {
      const o = pick(['reject_once']);
      return o ? { outcome: { outcome: 'selected', optionId: o.optionId } } : { outcome: { outcome: 'cancelled' } };
    }
    return new Promise((resolve) => {
      const title = req.toolCall?.title ?? 'run a tool';
      this.pendingPermission = { req, options, resolve };
      this.emit('permission', { title, options, resource: req._meta?.kiro?.consent?.resource, toolCall: req.toolCall });
      const ask = this.lastLang === 'fi' ? `Saanko luvan: ${title}? Sano kyllä tai ei.` : `May I ${title}? Say yes or no.`;
      if (this.turn) this.#say(this.turn, ask);
    });
  }

  resolvePermission(optionId) {
    const p = this.pendingPermission;
    if (!p) return;
    this.pendingPermission = null;
    if (!optionId) { p.resolve({ outcome: { outcome: 'cancelled' } }); this.emit('permission_resolved', null); return; }
    const res = { outcome: { outcome: 'selected', optionId } };
    // Kiro: a persistent ("always") choice echoes the consent scope + resource back.
    const opt = p.options.find((o) => o.optionId === optionId);
    const consent = p.req?._meta?.kiro?.consent;
    if (opt?.kind === 'allow_always' && consent?.persistableConsent) {
      const pc = consent.persistableConsent;
      const scope = pc.scope ?? pc.defaultScope ?? (Array.isArray(pc.scopes) ? pc.scopes[0] : undefined);
      res._meta = { kiro: { consent: { ...(scope ? { scope } : {}), resource: pc.resource ?? consent.resource } } };
    }
    p.resolve(res);
    this.emit('permission_resolved', optionId);
  }

  /** Cancel a pending permission (e.g. before superseding a blocked turn). */
  cancelPermission() { if (this.pendingPermission) this.resolvePermission(null); }

  #answerPermissionByVoice(text) {
    const p = this.pendingPermission;
    const yes = /\b(yes|yeah|yep|sure|ok(ay)?|go ahead|do it|kyllä|joo|juu|saa|okei|tee se)\b/i.test(text);
    const no = /\b(no|nope|don'?t|stop|cancel|ei|älä|peru)\b/i.test(text);
    const find = (k) => p.options.find((o) => o.kind === k)?.optionId;
    const always = /\b(always|aina|aina saa|ihan aina)\b/i.test(text);
    if (yes && !no) { this.resolvePermission(always ? (find('allow_always') ?? find('allow_once')) : (find('allow_once') ?? find('allow_always'))); return true; }
    if (no) { this.resolvePermission(find('reject_once') ?? null); return true; }
    return false; // not an answer: treat as a new instruction
  }

  #metrics(turn) {
    const m = turn.metrics;
    const d = (a, b) => (a && b ? b - a : null);
    return {
      turn: turn.id,
      fillerMs: d(m.endOfSpeechAt, m.fillerAt),
      sttMs: m.sttMs,
      agentFirstTokenMs: d(m.promptAt, m.firstTokenAt),
      ttsFirstAudioMs: d(m.firstSayAt, m.firstAudioAt),
      voiceToVoiceMs: d(m.endOfSpeechAt, m.firstAudioAt),
    };
  }
}
