// One command layer for every way of controlling the agent:
//   typed palette   ":model sonnet"   ":resume 2"   ":steer also add tests"
//   voice           "Vocalo, switch to model sonnet" / "Vocalo, vaihda malliin sonnet"
//   HTTP            POST /command {"type":"command","line":"/mode plan"}
// Commands run locally and instantly (no LLM round-trip). Unknown /slash commands
// are forwarded to the agent, so Kiro's own slash commands keep working.
import { EventEmitter } from 'node:events';

const WAKE = /^\s*(?:hey|hei|ok|okei)?[\s,]*(?:vocalo|vokalo|vocaloo|bocalo|wocalo|vokaalo)\b[\s,.:!?-]*/i;
const STOP_ONLY = /^\s*(?:stop|stop it|wait|hold on|cancel|shut up|quiet|seis|lopeta|odota|hiljaa|peru|keskeytä|stoppi)[\s.!]*$/i;

const FI_CMD = /\b(kerro|lyhyemmin|lyhyesti|tiiviimmin|tarkemmin|syvemmin|normaalisti|vaihda|käytä|uusi|aloita|jatka|tiivistä|näytä|listaa|avaa|peru|keskeytä|lopeta|tila|tilaan|ajattele|mieti|salli|kysy|paljonko|mikä|mitä|apua|lisäksi|sessio|istunto|malli)/i;
const IMG = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

/** Voice phrase -> command line. EN + FI. Returns null if not a command. */
export function voiceToCommand(text) {
  const t = text.trim().replace(/[.!?]+$/, '');
  const rules = [
    [/^(?:stop|cancel|abort|peru(?:uta)?|keskeytä|lopeta)(?: (?:that|it|kaikki|se|tehtävä))?$/i, () => 'cancel'],
    [/^(?:new|fresh|start a new) (?:session|chat|conversation)$|^(?:uusi|aloita uusi) (?:sessio|istunto|keskustelu)$/i, () => 'new'],
    [/^(?:resume|continue|open) (?:the )?(?:last|previous|latest) (?:session|chat)$|^jatka (?:edellistä|viimeisintä|viime) (?:sessiota|istuntoa|keskustelua)$/i, () => 'resume last'],
    [/^(?:list|show) (?:my )?sessions$|^(?:näytä|listaa) (?:sessiot|istunnot)$/i, () => 'sessions'],
    [/^(?:resume|open|jatka|avaa) (?:session|sessio|istunto)? ?(?:number |numero )?(\d+)$/i, (m) => `resume ${m[1]}`],
    [/^(?:switch to|use|change to|set) (?:the )?model (.+)$|^(?:switch|change) model to (.+)$|^(?:vaihda|käytä) (?:malli(?:in|a)?|mallia) (.+)$/i, (m) => `model ${m[1] ?? m[2] ?? m[3]}`],
    [/^(?:what|which) model(?: are you using| is this)?$|^(?:mikä|mitä) malli(?:a)?(?: käytät| on käytössä)?$/i, () => 'model'],
    [/^(?:set )?effort (?:to )?(low|medium|high|max)$|^(?:ajattele|mieti) (vähemmän|enemmän|kovemmin)$/i,
      (m) => `effort ${({ vähemmän: 'low', enemmän: 'high', kovemmin: 'high' })[m[2]] ?? m[1]}`],
    [/^(?:switch to|use|enter) (.+?) mode$|^(?:vaihda )?tila(?:an)? (.+)$|^(?:mode) (.+)$/i, (m) => `mode ${m[1] ?? m[2] ?? m[3]}`],
    [/^compact(?: the)?(?: context| conversation)?$|^tiivistä(?: konteksti| keskustelu)?$/i, () => 'compact'],
    [/^(?:how much )?context(?: left| usage)?$|^paljonko kontekstia(?: on jäljellä)?$/i, () => 'context'],
    [/^(?:show|open|näytä|avaa) (?:the )?(?:plan|suunnitelma)$/i, () => 'plan'],
    [/^(?:show|open|näytä|avaa) (?:the )?(?:last )?(?:diff|changes|muutokset|diffi)$/i, () => 'diff'],
    [/^(?:show|open|näytä|avaa) (?:me )?(?:the )?(?:file |tiedosto )(.+)$/i, (m) => `show ${m[1]}`],
    [/^(?:allow everything|auto approve|trust all|salli kaikki)$/i, () => 'permissions allow'],
    [/^(?:ask (?:me )?(?:first|before)|kysy (?:ensin|aina))$/i, () => 'permissions ask'],
    [/^(?:steer|also|lisäksi)[:,]? (.+)$/i, (m) => `steer ${m[1]}`],
    [/^(?:tell me more|more detail|go deeper|explain more|kerro tarkemmin|kerro lisää|syvemmin|tarkemmin)$/i, () => 'verbosity deep'],
    [/^(?:shorter|be brief|briefer|keep it short|lyhyemmin|lyhyesti|tiiviimmin)$/i, () => 'verbosity short'],
    [/^(?:normal length|normaalisti|normaali pituus)$/i, () => 'verbosity normal'],
    [/^(?:help|what can you do|apua|mitä osaat)$/i, () => 'help'],
  ];
  for (const [re, fn] of rules) { const m = re.exec(t); if (m) return fn(m); }
  return null;
}

export class Controller extends EventEmitter {
  constructor({ acp, orch, transport, ui, config = {} }) {
    super();
    Object.assign(this, { acp, orch, transport, ui });
    this.config = { autoCompactAt: 85, wakeWord: true, ...config };
    this.lastSessions = [];
    this.lastDiff = null;
    this.compacting = false;
    orch.intercept = (text, ctx) => this.#intercept(text, ctx);
    orch.on('diff', (d) => { this.lastDiff = d; });
    acp.on('session_state', (k) => this.#maybeAutoCompact(k));
    orch.on('state', (st) => { if (st === 'idle') this.#maybeAutoCompact(acp.kiro); });
  }

  // ---------------- speech-facing intercept
  async #intercept(text, ctx) {
    if (ctx.busy && STOP_ONLY.test(text)) { await this.run('cancel', { voice: true }); return true; }
    const m = WAKE.exec(text);
    if (!m) return false;
    const rest = text.slice(m[0].length).trim();
    if (!rest) { this.orch.announce(this.#fi() ? 'Niin?' : 'Yes?'); return true; }
    const cmd = voiceToCommand(rest);
    if (!cmd) return false; // "Vocalo, explain X" is just a normal prompt
    // reply in the language the command was spoken in
    this.orch.lastLang = FI_CMD.test(rest) ? 'fi' : /^[a-z ,'0-9-]+$/i.test(rest) ? 'en' : this.orch.lastLang;
    await this.run(cmd, { voice: true });
    return true;
  }

  #fi() { return this.orch.lastLang === 'fi'; }
  #say(en, fi, ctx) { if (ctx?.voice || this.config.speakConfirmations) this.orch.announce(this.#fi() ? fi : en); this.emit('info', this.#fi() ? fi : en); }

  // ---------------- command execution
  /** @param {string} line e.g. "model sonnet" or "/model sonnet" */
  async run(line, ctx = {}) {
    const raw = line.trim().replace(/^[:/]/, '');
    const [name, ...rest] = raw.split(/\s+/);
    const arg = rest.join(' ').trim();
    const cmd = (name || '').toLowerCase();
    try {
      switch (cmd) {
        case 'help': return this.#overlay('Commands', HELP.split('\n'));
        case 'cancel': case 'stop': await this.orch.interrupt('command'); return this.#say('Stopped.', 'Keskeytetty.', ctx);
        case 'model': case 'effort': case 'mode': return this.#option(cmd, arg, ctx);
        case 'options': return this.#overlay('Session options', this.acp.configOptions.map((o) =>
          `${o.configId ?? o.id}: ${o.currentValue}   [${(o.options ?? []).map((v) => v.value).join(', ')}]`));
        case 'sessions': return this.#sessions();
        case 'resume': return this.#resume(arg, ctx);
        case 'new': return this.#new(ctx);
        case 'compact': return this.#compact(ctx);
        case 'context': return this.#context(ctx);
        case 'usage': return this.#extOverlay('_kiro/account/getUsage', 'Usage');
        case 'mcp': return this.#extOverlay('_kiro/mcp/status', 'MCP servers');
        case 'steer':
          if (!arg) return this.emit('info', 'usage: steer <text>');
          if (this.orch.turn) { await this.acp.steer(arg); return this.emit('info', `steered: ${arg}`); }
          return this.orch.userSaid(arg, {});
        case 'permissions': case 'perm':
          if (!['ask', 'allow', 'deny'].includes(arg)) return this.emit('info', `permissions: ${this.orch.config.permissions} (ask|allow|deny)`);
          this.orch.config.permissions = arg;
          return this.#say(`Permissions: ${arg}.`, `Luvat: ${({ ask: 'kysy', allow: 'salli', deny: 'estä' })[arg]}.`, ctx);
        case 'verbosity': case 'v':
          if (!this.orch.setVerbosity(arg)) return this.emit('info', `verbosity: ${this.orch.config.verbosity} (short|normal|deep)`);
          return this.#say({ short: 'Okay, short answers.', normal: 'Okay, normal length.', deep: 'Okay, more detail.' }[arg],
            { short: 'Okei, lyhyesti.', normal: 'Okei, normaalisti.', deep: 'Okei, tarkemmin.' }[arg], ctx);
        case 'busy':
          if (!['steer', 'interrupt', 'queue'].includes(arg)) return this.emit('info', `busy policy: ${this.orch.config.busyPolicy} (steer|interrupt|queue)`);
          this.orch.config.busyPolicy = arg; return this.emit('info', `busy policy: ${arg}`);
        case 'show': return this.#show(arg, ctx);
        case 'diff':
          if (!this.lastDiff) return this.#say('No changes yet.', 'Ei muutoksia vielä.', ctx);
          return this.emit('diff', this.lastDiff);
        case 'plan': return this.emit('toggle_plan');
        case 'exec': case 'sh': { // read-only peek on the agent's machine, e.g. ":sh git status -s"
          const out = await this.transport.exec(arg, { timeoutMs: 20000 });
          return this.emit('code', `$ ${arg}\n${out}`);
        }
        case 'agent': return this.#overlay('Agent', [
          `${this.acp.agentInfo?.title ?? this.acp.agentInfo?.name ?? '?'} ${this.acp.agentInfo?.version ?? ''}`,
          `where: ${this.transport.label}`, `session: ${this.acp.sessionId}`,
          `extensions: ${this.acp.extensionMethods.join(', ') || '(none)'}`]);
        default:
          // Not ours: let the agent handle its own slash command.
          return this.orch.userSaid(`/${raw}`, {});
      }
    } catch (err) {
      this.emit('info', `${cmd}: ${err.message}`);
      if (ctx.voice) this.orch.announce(this.#fi() ? 'Se ei onnistunut.' : "That didn't work.");
    }
  }

  async #option(kind, arg, ctx) {
    const id = kind === 'effort' ? (this.acp.option('effortLevel') ? 'effortLevel' : 'thought_level') : kind;
    const opt = this.acp.option(id);
    if (!arg || arg === 'list') {
      if (kind === 'mode' && !opt && this.acp.kiro.modes) {
        const m = this.acp.kiro.modes;
        return this.#overlay('Modes', m.availableModes.map((x) => `${x.id === m.currentModeId ? '▶' : ' '} ${x.id}  ${x.name ?? ''}`));
      }
      if (!opt) return this.emit('info', `agent offers no ${kind} option`);
      if (ctx.voice) return this.#say(`Current ${kind}: ${opt.currentValue}.`, `Nykyinen ${kind}: ${opt.currentValue}.`, ctx);
      return this.#overlay(opt.name ?? kind, (opt.options ?? []).map((v) =>
        `${v.value === opt.currentValue ? '▶' : ' '} ${v.value}${v.name && v.name !== v.value ? `  ${v.name}` : ''}${v.description ? `  — ${v.description}` : ''}`),
        (opt.options ?? []).map((v) => `${kind} ${v.value}`));
    }
    if (kind === 'mode' && !opt) {
      const m = this.acp.kiro.modes?.availableModes?.find((x) => x.id.toLowerCase() === arg.toLowerCase() || (x.name ?? '').toLowerCase() === arg.toLowerCase());
      await this.acp.setMode(m?.id ?? arg);
      return this.#say(`Mode ${m?.id ?? arg}.`, `Tila ${m?.id ?? arg}.`, ctx);
    }
    const v = this.acp.matchValue(id, arg);
    if (!v) return this.#say(`I don't have ${kind} ${arg}.`, `En löydä vaihtoehtoa ${arg}.`, ctx);
    if (kind === 'mode') await this.acp.setMode(v.value); else await this.acp.setConfigOption(id, v.value);
    this.#say(`${kind[0].toUpperCase() + kind.slice(1)}: ${v.name ?? v.value}.`, `${({ model: 'Malli', effort: 'Ajattelu', mode: 'Tila' })[kind]}: ${v.name ?? v.value}.`, ctx);
  }

  async #sessions() {
    this.lastSessions = await this.acp.listSessions({ cwd: this.acp.cwd });
    if (!this.lastSessions.length) return this.emit('info', 'no sessions for this folder');
    const shown = this.lastSessions.slice(0, 15);
    return this.#overlay('Sessions  (:resume N)', shown.map((s, i) =>
      `${String(i + 1).padStart(2)}. ${s.id === this.acp.sessionId ? '▶ ' : ''}${s.title || '(untitled)'}  ${fmtTime(s.updatedAt)}  ${s.id.slice(0, 12)}`),
      shown.map((s, i) => (s.id === this.acp.sessionId ? null : `resume ${i + 1}`)));
  }

  async #resume(arg, ctx) {
    if (!this.lastSessions.length || arg === 'last') this.lastSessions = await this.acp.listSessions({ cwd: this.acp.cwd });
    const pool = this.lastSessions.filter((s) => s.id !== this.acp.sessionId);
    const pick = !arg || arg === 'last' ? pool[0]
      : /^\d+$/.test(arg) ? this.lastSessions[Number(arg) - 1]
      : this.lastSessions.find((s) => s.id.startsWith(arg) || s.title.toLowerCase().includes(arg.toLowerCase()));
    if (!pick) return this.#say('No session to resume.', 'Ei jatkettavaa sessiota.', ctx);
    await this.orch.interrupt('resume');
    await this.acp.loadSession({ sessionId: pick.id, cwd: this.acp.cwd });
    this.orch.preambleSent = false; // re-prime voice mode in the resumed session
    this.emit('session_changed', pick);
    this.#say(`Resumed: ${pick.title || 'session'}.`, `Jatketaan: ${pick.title || 'sessio'}.`, ctx);
  }

  async #new(ctx) {
    await this.orch.interrupt('new-session');
    const keep = Object.fromEntries(['model', 'effortLevel'].map((k) => [k === 'model' ? 'modelId' : k, this.acp.current(k)]).filter(([, v]) => v));
    await this.acp.newSession({ cwd: this.acp.cwd, mcpServers: [], kiro: keep });
    this.orch.preambleSent = false;
    this.emit('session_changed', { id: this.acp.sessionId });
    this.#say('New session.', 'Uusi sessio.', ctx);
  }

  async #compact(ctx) {
    if (this.compacting) return;
    this.compacting = true;
    try {
      this.#say('Compacting the context.', 'Tiivistän kontekstin.', ctx);
      const r = await this.acp.ext('_kiro/session/compact');
      if (r === null) await this.orch.userSaid('/compact', {}); // fall back to the agent's slash command
    } finally { this.compacting = false; }
  }

  async #context(ctx) {
    const pct = this.acp.kiro.contextPct;
    const detail = await this.acp.ext('_kiro/session/context').catch(() => null);
    if (detail) this.#overlay('Context', JSON.stringify(detail, null, 2).split('\n').slice(0, 30));
    if (pct != null) this.#say(`Context is ${Math.round(pct)} percent full.`, `Konteksti on ${Math.round(pct)} prosenttia täynnä.`, { voice: ctx.voice || !detail });
    else if (!detail) this.emit('info', 'agent reports no context usage');
  }

  async #extOverlay(method, title) {
    const r = await this.acp.ext(method);
    if (r === null) return this.emit('info', `agent does not offer ${method}`);
    this.#overlay(title, JSON.stringify(r, null, 2).split('\n').slice(0, 40));
  }

  async #show(arg, ctx) {
    if (!arg) return this.emit('info', 'usage: show <path|url>');
    if (/^https?:/.test(arg)) return this.emit('scene', { kind: 'show', image: arg });
    const buf = await this.transport.readFile(arg);
    if (IMG.test(arg)) return this.emit('scene', { kind: 'show', imageData: buf.toString('base64'), caption: arg });
    this.emit('code', `${arg}\n${'─'.repeat(Math.min(60, arg.length))}\n${buf.toString('utf8')}`);
    if (ctx.voice) this.#say(`Here's ${arg.split('/').pop()}.`, `Tässä ${arg.split('/').pop()}.`, ctx);
  }

  #overlay(title, lines, picks = []) { this.emit('overlay', { title, lines, picks }); }

  async #maybeAutoCompact(k) {
    const at = this.config.autoCompactAt;
    if (!at || k.contextPct == null || k.contextPct < at || this.compacting || this.orch.turn) return;
    if (!this.acp.supports('_kiro/session/compact')) return;
    if (this.autoCompactedAt && Date.now() - this.autoCompactedAt < 120000) return;
    this.autoCompactedAt = Date.now();
    await this.#compact({ voice: true });
  }
}

function fmtTime(t) {
  if (!t) return '';
  const d = new Date(typeof t === 'number' && t < 1e12 ? t * 1000 : t);
  return isNaN(d) ? String(t) : d.toISOString().slice(0, 16).replace('T', ' ');
}

export const HELP = `:model [name]        list or switch model         "Vocalo, switch to model …" / "vaihda malliin …"
:effort low|high     reasoning effort             "Vocalo, effort low"
:mode [id]           list or switch agent mode    "Vocalo, switch to plan mode"
:options             all session options
:sessions            list sessions for this folder "Vocalo, show sessions"
:resume [N|last|id]  re-attach to a session       "Vocalo, jatka edellistä sessiota"
:new                 fresh session                "Vocalo, uusi sessio"
:compact  :context   context management           "Vocalo, tiivistä"
:steer <text>        add guidance to the running turn without stopping it
:verbosity short|normal|deep  answer length       "Vocalo, kerro tarkemmin" / "lyhyemmin"
:busy steer|interrupt|queue   what talking during agent work does
:permissions ask|allow|deny
:show <path|url>     show a file/screenshot from the agent's machine ("mac:" prefix = local)
:diff  :plan         last code change / the agent's plan
:sh <cmd>            run a quick command on the agent's machine and show output
:usage  :mcp  :agent Kiro account usage, MCP status, connection info
:cancel              stop the current turn        "stop" / "seis" while it works
/<anything else>     forwarded to the agent as a slash command`;
