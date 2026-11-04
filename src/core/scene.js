// Extracts "stage directions" from the agent's streamed text.
// The agent (via steering) writes tags such as:
//   [[scene bg="#0b1d3a" title="Photosynthesis" image="https://…/leaf.jpg"]]
//   [[show image="./diagram.png" caption="The light reaction"]]
//   [[clear]]
// Tags are removed from speech and subtitles and emitted as scene events.
// Tags may be split across stream chunks; the parser buffers safely.

const ATTR = /(\w+)\s*=\s*(?:"([^"]*)"|'([^']*)'|(\S+))/g;

export function parseTag(body) {
  const trimmed = body.trim();
  const sp = trimmed.search(/\s/);
  const kind = (sp < 0 ? trimmed : trimmed.slice(0, sp)).toLowerCase();
  const attrs = {};
  const rest = sp < 0 ? '' : trimmed.slice(sp);
  let m;
  ATTR.lastIndex = 0;
  while ((m = ATTR.exec(rest))) attrs[m[1]] = m[2] ?? m[3] ?? m[4];
  return { kind, ...attrs };
}

export class SceneParser {
  constructor({ onText, onScene, maxTag = 600 } = {}) {
    Object.assign(this, { onText, onScene, maxTag });
    this.buf = '';
  }

  push(chunk) {
    this.buf += chunk;
    let out = '';
    for (;;) {
      const open = this.buf.indexOf('[[');
      if (open < 0) {
        // hold back a trailing "[" that might start a tag
        const hold = this.buf.endsWith('[') ? 1 : 0;
        out += this.buf.slice(0, this.buf.length - hold);
        this.buf = this.buf.slice(this.buf.length - hold);
        break;
      }
      out += this.buf.slice(0, open);
      const close = this.buf.indexOf(']]', open + 2);
      if (close < 0) {
        if (this.buf.length - open > this.maxTag) { // not a real tag; release it
          out += this.buf.slice(open, open + 2);
          this.buf = this.buf.slice(open + 2);
          continue;
        }
        this.buf = this.buf.slice(open);
        break;
      }
      const tag = parseTag(this.buf.slice(open + 2, close));
      if (tag.kind) this.onScene?.(tag);
      this.buf = this.buf.slice(close + 2);
    }
    if (out) this.onText?.(out);
  }

  flush() {
    if (this.buf) this.onText?.(this.buf);
    this.buf = '';
  }
}
