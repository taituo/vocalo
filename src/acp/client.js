// Dependency-free ACP client with first-class Kiro CLI V3 support.
// Transport: newline-delimited JSON-RPC 2.0 over the agent's stdio (local or via SSH).
//
// Kiro rules this client follows (kiro.dev/docs/cli/v3/acp-migration):
//  - capabilities from `initialize` are authoritative; every _kiro/* call is gated on
//    agentCapabilities._meta.kiro.extensionMethods
//  - model/effort via session/set_config_option; modes via session/set_mode or a "mode" option
//  - sessions via session/list + session/load (never read ~/.kiro files)
//  - a turn settles only on the session/prompt response; unknown updates/_meta are ignored
//  - unsupported agent->client requests get an explicit JSON-RPC error
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';
import { Transport } from './transport.js';

const optId = (o) => o?.configId ?? o?.id;

export class AcpClient extends EventEmitter {
  /**
   * @param {object} opts  either { transport } or legacy { command, args, cwd, env }
   * @param {(req) => Promise<object>} [opts.onPermission]
   * @param {(url) => Promise<boolean>} [opts.onOpenUrl]  open a URL on the user's machine
   */
  constructor({ transport, command, args = [], env = {}, cwd = process.cwd(), onPermission, onOpenUrl } = {}) {
    super();
    this.transport = transport ?? new Transport({ command, args, cwd, env });
    this.cwd = this.transport.cwd ?? cwd;
    this.onPermission = onPermission;
    this.onOpenUrl = onOpenUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.capabilities = null;
    this.sessionId = null;
    this.proc = null;
    this.promptKey = 'prompt';
    this.resetSessionState();
  }

  resetSessionState() {
    this.kiro = {
      configOptions: [],   // [{id/configId, name, category, type, currentValue, options[]}]
      modes: null,         // { currentModeId, availableModes[] } (legacy modes API)
      commands: [],        // available_commands_update
      contextPct: null,    // session_info_update kind=context_usage
      plan: [],            // standard ACP plan entries
      title: null,
    };
  }

  // ------------------------------------------------------------------ process
  start() {
    this.proc = this.transport.spawnAgent();
    const proc = this.proc;
    proc.on('error', (err) => this.emit('stderr', `spawn error: ${err.message}\n`));
    proc.on('exit', (code, sig) => {
      if (this.proc !== proc) return;
      for (const { reject } of this.pending.values()) reject(new Error(`ACP agent exited (${code ?? sig})`));
      this.pending.clear();
      this.proc = null;
      this.emit('exit', code, sig);
    });
    proc.stdin.on('error', () => {}); // EPIPE after the agent died is reported via 'exit'
    proc.stderr.on('data', (d) => this.emit('stderr', d.toString()));
    createInterface({ input: proc.stdout }).on('line', (line) => this.#onLine(line));
    return this;
  }

  stop() {
    const p = this.proc;
    this.proc = null;
    try { p?.stdin.end(); } catch {}
    try { p?.kill('SIGTERM'); } catch {}
  }

  get alive() { return !!this.proc; }

  #send(msg) {
    if (!this.proc) throw new Error('ACP agent is not running');
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  request(method, params, { timeoutMs = 0 } = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      let timer;
      if (timeoutMs) timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      try { this.#send({ jsonrpc: '2.0', id, method, params }); }
      catch (e) { this.pending.delete(id); clearTimeout(timer); reject(e); }
    });
  }

  notify(method, params) {
    try { this.#send({ jsonrpc: '2.0', method, params }); } catch {}
  }

  #reply(id, result) { try { this.#send({ jsonrpc: '2.0', id, result }); } catch {} }
  #replyError(id, code, message) { try { this.#send({ jsonrpc: '2.0', id, error: { code, message } }); } catch {} }

  async #onLine(line) {
    line = line.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch { this.emit('stderr', `non-JSON from agent: ${line.slice(0, 200)}\n`); return; }

    if (msg.id !== undefined && !msg.method) {           // response
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'ACP error'), { code: msg.error.code, data: msg.error.data }));
      else p.resolve(msg.result);
      return;
    }
    if (msg.method && msg.id === undefined) {            // notification
      if (msg.method === 'session/update') this.#onUpdate(msg.params);
      else this.emit('notification', msg.method, msg.params);
      return;
    }
    if (msg.method && msg.id !== undefined) {            // agent -> client request
      try {
        if (msg.method === 'session/request_permission') {
          const outcome = this.onPermission ? await this.onPermission(msg.params) : { outcome: { outcome: 'cancelled' } };
          this.#reply(msg.id, outcome);
        } else if (msg.method === '_kiro/openExternalUrl' && this.onOpenUrl) {
          const opened = await this.onOpenUrl(msg.params?.url, msg.params);
          this.#reply(msg.id, { opened: !!opened });
        } else {
          this.#replyError(msg.id, -32601, `Method not supported by Vocalo: ${msg.method}`);
        }
      } catch (err) {
        this.#replyError(msg.id, -32603, String(err?.message || err));
      }
    }
  }

  // Keep a live model of the session (config, mode, context, commands, plan) for the UI.
  #onUpdate(params) {
    const u = params?.update ?? params;
    const k = this.kiro;
    switch (u?.sessionUpdate) {
      case 'config_option_update':
        if (Array.isArray(u.configOptions)) { k.configOptions = u.configOptions; this.emit('session_state', k); }
        break;
      case 'current_mode_update':
        if (k.modes) k.modes.currentModeId = u.currentModeId ?? u.modeId;
        this.#setOptionValue('mode', u.currentModeId ?? u.modeId, false);
        this.emit('session_state', k);
        break;
      case 'available_commands_update':
        k.commands = u.availableCommands ?? u.commands ?? [];
        this.emit('session_state', k);
        break;
      case 'plan':
        k.plan = u.entries ?? [];
        break;
      case 'session_info_update': {
        const kind = u._meta?.kiro?.kind;
        if (kind === 'context_usage') {
          const pct = u._meta.kiro.usagePercentage ?? u.usagePercentage;
          if (typeof pct === 'number') { k.contextPct = pct; this.emit('session_state', k); }
        }
        if (u.title) { k.title = u.title; this.emit('session_state', k); }
        this.emit('session_info', { kind, update: u });
        break;
      }
    }
    this.emit('update', params);
  }

  #setOptionValue(idOrCategory, value, emit = true) {
    const o = this.kiro.configOptions.find((x) => optId(x) === idOrCategory || x.category === idOrCategory);
    if (o && value !== undefined) { o.currentValue = value; if (emit) this.emit('session_state', this.kiro); }
  }

  // ------------------------------------------------------------------ protocol
  async initialize() {
    const res = await this.request('initialize', {
      protocolVersion: 1,
      // Vocalo is a voice client: the agent keeps using its own filesystem/terminal
      // (which, in remote mode, is the remote machine). We only offer URL opening.
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        ...(this.onOpenUrl ? { _meta: { kiro: { openExternalUrl: true } } } : {}),
      },
      clientInfo: { name: 'vocalo', title: 'Vocalo', version: '0.3.0' },
    }, { timeoutMs: 60000 });
    this.capabilities = res?.agentCapabilities ?? {};
    this.agentInfo = res?.agentInfo;
    return res;
  }

  get extensionMethods() { return this.capabilities?._meta?.kiro?.extensionMethods ?? []; }
  supports(method) { return this.extensionMethods.includes(method); }
  get canLoadSession() { return !!this.capabilities?.loadSession; }
  get canListSessions() { return !!(this.capabilities?.sessionCapabilities?.list ?? this.capabilities?.listSessions ?? true); }
  get isKiro() { return /kiro/i.test(this.agentInfo?.name ?? '') || this.extensionMethods.length > 0; }

  #absorbSession(res) {
    if (Array.isArray(res?.configOptions)) this.kiro.configOptions = res.configOptions;
    if (res?.modes) this.kiro.modes = res.modes;
    this.emit('session_state', this.kiro);
  }

  async newSession({ cwd = this.cwd, mcpServers = [], additionalDirectories, kiro } = {}) {
    const params = { cwd, mcpServers };
    if (additionalDirectories?.length) params.additionalDirectories = additionalDirectories;
    if (kiro && Object.keys(kiro).length) params._meta = { kiro }; // modeId, modelId, effortLevel
    this.resetSessionState();
    const res = await this.request('session/new', params, { timeoutMs: 120000 });
    this.sessionId = res.sessionId;
    this.#absorbSession(res);
    return res;
  }

  /** Re-attach to a session. noReplay: don't stream the old transcript back. */
  async loadSession({ sessionId = this.sessionId, cwd = this.cwd, mcpServers = [], noReplay = true } = {}) {
    this.resetSessionState();
    this.sessionId = sessionId; // Kiro: keep the requested id, don't rely on the response
    const res = await this.request('session/load', { sessionId, cwd, mcpServers, noReplay }, { timeoutMs: 120000 });
    this.#absorbSession(res);
    return res;
  }

  async listSessions({ cwd = this.cwd } = {}) {
    const res = await this.request('session/list', cwd ? { cwd } : {}, { timeoutMs: 20000 });
    const list = res?.sessions ?? (Array.isArray(res) ? res : []);
    return list.map((s) => ({ id: s.sessionId ?? s.id, title: s.title ?? s.name ?? '', updatedAt: s.updatedAt ?? s.lastModified ?? s.modifiedAt, cwd: s.cwd }))
      .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  }

  /** All selectable options in agent order: model, effort, mode, ... */
  get configOptions() { return this.kiro.configOptions; }
  option(idOrCategory) { return this.kiro.configOptions.find((o) => optId(o) === idOrCategory || o.category === idOrCategory); }
  current(idOrCategory) { return this.option(idOrCategory)?.currentValue ?? null; }

  /** Resolve a spoken/typed value ("sonnet", "nopea") against the option's choices. */
  matchValue(idOrCategory, wanted) {
    const o = this.option(idOrCategory);
    const opts = o?.options ?? [];
    const w = String(wanted).toLowerCase().trim();
    return opts.find((v) => String(v.value).toLowerCase() === w)
      ?? opts.find((v) => String(v.name ?? '').toLowerCase() === w)
      ?? opts.find((v) => `${v.value} ${v.name ?? ''}`.toLowerCase().includes(w)) ?? null;
  }

  async setConfigOption(configId, value) {
    const o = this.option(configId);
    const id = o ? optId(o) : configId;
    const res = await this.request('session/set_config_option', { sessionId: this.sessionId, configId: id, value }, { timeoutMs: 20000 });
    if (Array.isArray(res?.configOptions)) this.kiro.configOptions = res.configOptions;
    else this.#setOptionValue(id, value, false);
    this.emit('session_state', this.kiro);
    return res;
  }

  async setMode(modeId) {
    if (this.option('mode')) return this.setConfigOption('mode', modeId);
    const res = await this.request('session/set_mode', { sessionId: this.sessionId, modeId }, { timeoutMs: 20000 });
    if (this.kiro.modes) this.kiro.modes.currentModeId = modeId;
    this.emit('session_state', this.kiro);
    return res;
  }

  /** Resolves when the turn ends (stopReason). Streaming arrives via 'update' events. */
  async prompt(text, extraBlocks = []) {
    const blocks = [{ type: 'text', text }, ...extraBlocks];
    try {
      return await this.request('session/prompt', { sessionId: this.sessionId, [this.promptKey]: blocks });
    } catch (err) {
      // Older Kiro builds documented `content` instead of the spec's `prompt`.
      if (err.code === -32602 && this.promptKey === 'prompt') {
        this.promptKey = 'content';
        return this.request('session/prompt', { sessionId: this.sessionId, content: blocks });
      }
      throw err;
    }
  }

  cancel() {
    if (this.sessionId) this.notify('session/cancel', { sessionId: this.sessionId });
  }

  /**
   * Kiro live steering: add guidance to the RUNNING turn without cancelling it.
   * The method name is documented (it keeps its `_session/` prefix in V3); the payload
   * shape is not, so we send the ACP-standard prompt block shape.
   */
  async steer(text) {
    if (!this.supports('_session/steer')) throw new Error('agent does not advertise _session/steer');
    return this.request('_session/steer', { sessionId: this.sessionId, prompt: [{ type: 'text', text }] }, { timeoutMs: 15000 });
  }

  /** Call an advertised Kiro extension; returns null when the agent doesn't offer it. */
  async ext(method, params = {}) {
    if (!this.supports(method)) return null;
    return this.request(method, { sessionId: this.sessionId, ...params }, { timeoutMs: 60000 });
  }
}
