// The "talker" in a talker + thinker voice architecture.
//
// Kiro (the thinker) is smart but can take seconds before its first word, and
// minutes when it runs tools. A small fast model (the talker) keeps the
// conversation alive in the meantime:
//   * ack:      an instant, *contextual* acknowledgement ("Joo, katsotaan se testi.")
//               in the user's language, without answering (Kiro does that)
//   * narrate:  a short spoken progress line while Kiro works ("Ajan nyt testit…")
//
// Any OpenAI-compatible chat endpoint works: `mlx_lm.server` or LM Studio on the Mac
// (fully local), Ollama, or a fast cloud model. Strict deadlines: if the talker is slow,
// we just skip it. The thinker is never blocked by the talker.

const ACK_SYSTEM = `You are the instant voice of an assistant. The user just said something to the assistant.
Reply with ONE very short spoken acknowledgement (2 to 7 words) in the SAME language as the user (Finnish, English, or their mix), in their register.
It must show you understood WHAT they said (mention the topic), but must NOT answer, decide, promise results, or ask a question.
No emoji, no quotes, no markdown. Examples:
user: "voitko katsoa miksi testit failaa" -> Joo, katsotaan ne testit.
user: "explain how photosynthesis works" -> Ah, photosynthesis, sure.
user: "lisää tohon funktioon virheenkäsittely" -> Selvä, virheenkäsittely siihen.
user: "hmm what was that config thing again" -> The config thing, let me look.`;

const NARRATE_SYSTEM = `You narrate what an AI coding agent is doing right now, for a user who is listening.
Write ONE short spoken sentence (max 10 words) in the requested language, present tense, casual, no emoji or markdown.
Never invent results. Only describe the activity.`;

export class Talker {
  /**
   * @param {object} cfg
   * @param {string} cfg.url    base URL of an OpenAI-compatible API, e.g. http://127.0.0.1:8080/v1
   * @param {string} cfg.model
   * @param {string} [cfg.apiKey]
   * @param {number} [cfg.ackDeadlineMs]  give up on an ack after this long
   */
  constructor({ url, model, apiKey, ackDeadlineMs = 900, narrateDeadlineMs = 2500, fetchImpl = globalThis.fetch } = {}) {
    Object.assign(this, { url: url?.replace(/\/$/, ''), model, apiKey, ackDeadlineMs, narrateDeadlineMs, fetch: fetchImpl });
    this.stats = { ok: 0, late: 0, failed: 0, lastMs: null };
  }

  get enabled() { return !!(this.url && this.model); }

  async #complete(system, user, { deadlineMs, maxTokens = 24, signal } = {}) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), deadlineMs);
    signal?.addEventListener('abort', () => ctrl.abort());
    const t0 = Date.now();
    try {
      const res = await this.fetch(`${this.url}/chat/completions`, {
        method: 'POST',
        signal: ctrl.signal,
        headers: { 'content-type': 'application/json', ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) },
        body: JSON.stringify({
          model: this.model, max_tokens: maxTokens, temperature: 0.6, stream: false,
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          // ask reasoning models not to think; ignored by servers that don't know it
          chat_template_kwargs: { enable_thinking: false },
        }),
      });
      if (!res.ok) throw new Error(`talker HTTP ${res.status}`);
      const j = await res.json();
      this.stats.ok++; this.stats.lastMs = Date.now() - t0;
      return clean(j.choices?.[0]?.message?.content ?? '');
    } catch (err) {
      if (ctrl.signal.aborted) this.stats.late++; else this.stats.failed++;
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Contextual acknowledgement, or null if it can't be had within the deadline. */
  async ack(userText, { signal } = {}) {
    if (!this.enabled) return null;
    const out = await this.#complete(ACK_SYSTEM, `user: "${userText.slice(0, 400)}"`, { deadlineMs: this.ackDeadlineMs, signal });
    if (!out || out.split(/\s+/).length > 9 || /\?$/.test(out)) return null; // guard: short, no questions
    return out;
  }

  /** Spoken progress line from tool/plan state, or null. */
  async narrate({ lang, tools = [], plan = [] }, { signal } = {}) {
    if (!this.enabled) return null;
    const now = plan.find((e) => e.status === 'in_progress')?.content;
    const desc = [now && `current plan step: ${now}`, tools.length && `running: ${tools.slice(-3).join('; ')}`].filter(Boolean).join('. ');
    if (!desc) return null;
    return this.#complete(NARRATE_SYSTEM, `language: ${lang === 'fi' ? 'Finnish' : 'English'}. ${desc}`, { deadlineMs: this.narrateDeadlineMs, maxTokens: 30, signal });
  }
}

/** Template narration when no talker model is configured: zero latency, always on. */
export function templateNarration({ lang, tools = [], plan = [] }) {
  const now = plan.find((e) => e.status === 'in_progress')?.content;
  const tool = tools.at(-1);
  const what = (now || tool || '').replace(/[`*_#]/g, '').slice(0, 70);
  if (!what) return null;
  return lang === 'fi' ? `Työn alla: ${what}.` : `Working on: ${what}.`;
}

function clean(s) {
  return s.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/^["'“”\s]+|["'“”\s]+$/g, '').replace(/\s+/g, ' ').split('\n')[0].trim();
}
