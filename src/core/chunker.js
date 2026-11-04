// Turns a token stream into speakable chunks as early as possible.
// Latency trick: the FIRST chunk is released at the first clause boundary
// (", ; : —") once it is long enough, so TTS starts ~one clause in.
// Later chunks are whole sentences (better prosody), capped in length.
// Fenced code blocks are never spoken; they are emitted via onCode for the screen.

const SENT_END = /[.!?…]["')\]]?(?=\s)|\n/g;
const CLAUSE_END = /[,;:—–](?=\s)/g;
const FENCE = '```';

export class SpeechChunker {
  constructor({ onSpeak, onCode, firstMin = 18, sentMin = 30, maxLen = 220 } = {}) {
    Object.assign(this, { onSpeak, onCode, firstMin, sentMin, maxLen });
    this.reset();
  }

  reset() {
    this.raw = '';      // unparsed input (may hold a partial fence)
    this.speech = '';   // text waiting to be spoken
    this.code = '';
    this.inCode = false;
    this.emitted = 0;
  }

  push(text) {
    this.raw += text;
    this.#split(false);
    this.#drain(false);
  }

  flush() {
    this.#split(true);
    if (this.inCode && this.code.trim()) this.onCode?.(this.code);
    this.#drain(true);
    this.reset();
  }

  // Route raw text into speech/code, honouring ``` fences split across tokens.
  #split(final) {
    for (;;) {
      const i = this.raw.indexOf(FENCE);
      if (i < 0) {
        const keep = final ? 0 : Math.min(2, this.raw.length); // fence may be split
        const take = this.raw.slice(0, this.raw.length - keep);
        if (this.inCode) this.code += take; else this.speech += take;
        this.raw = this.raw.slice(this.raw.length - keep);
        return;
      }
      const before = this.raw.slice(0, i);
      this.raw = this.raw.slice(i + FENCE.length);
      if (this.inCode) {
        this.code += before;
        this.onCode?.(this.code.replace(/^[\w+-]*\n/, ''));
        this.code = '';
        this.inCode = false;
      } else {
        this.speech += before;
        this.#drain(true); // speak everything before the code block now
        this.inCode = true;
      }
    }
  }

  #drain(final) {
    for (;;) {
      const cut = this.#findCut();
      if (cut < 0) break;
      this.#emit(this.speech.slice(0, cut));
      this.speech = this.speech.slice(cut);
    }
    if (final && this.speech.trim()) this.#emit(this.speech);
    if (final) this.speech = '';
  }

  #findCut() {
    const b = this.speech;
    const first = this.emitted === 0;
    const min = first ? this.firstMin : this.sentMin;
    let m;
    SENT_END.lastIndex = 0;
    while ((m = SENT_END.exec(b))) {
      const end = m.index + m[0].length;
      if (end >= (first ? 2 : min)) return end;
    }
    if (first) {
      CLAUSE_END.lastIndex = 0;
      while ((m = CLAUSE_END.exec(b))) {
        const end = m.index + m[0].length;
        if (end >= min) return end;
      }
    }
    if (b.length > this.maxLen) {
      const sp = b.lastIndexOf(' ', this.maxLen);
      return sp > min ? sp : this.maxLen;
    }
    return -1;
  }

  #emit(raw) {
    const text = cleanForSpeech(raw);
    if (!text || !/[\p{L}\p{N}]/u.test(text)) return;
    this.emitted++;
    this.onSpeak?.(text);
  }
}

export function cleanForSpeech(s) {
  return s
    .replace(/`([^`]*)`/g, '$1')             // inline code -> plain
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')    // images
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // links -> label
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')      // headings
    .replace(/^\s*[-*+]\s+/gm, '')           // bullets
    .replace(/\*\*|__|~~|\*/g, '')           // emphasis
    .replace(/https?:\/\/\S+/g, 'link')      // raw URLs
    .replace(/\s+/g, ' ')
    .trim();
}
