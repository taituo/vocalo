// Minimal, dependency-free ACP (Agent Client Protocol) client.
// Transport: newline-delimited JSON-RPC 2.0 over the agent's stdin/stdout.
// Works with any ACP agent; Kiro CLI V3 is the default target:
//   kiro-cli acp --agent-engine=v3
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createInterface } from 'node:readline';

export class AcpClient extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.command  executable (full path recommended)
   * @param {string[]} [opts.args]
   * @param {object} [opts.env]
   * @param {string} [opts.cwd]
   * @param {(req) => Promise<object>} [opts.onPermission] resolves to an ACP permission outcome
   */
  constructor({ command, args = [], env = {}, cwd = process.cwd(), onPermission } = {}) {
    super();
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.onPermission = onPermission;
    this.nextId = 1;
    this.pending = new Map();
    this.capabilities = null;
    this.sessionId = null;
    this.proc = null;
  }

  start() {
    this.proc = spawn(this.command, this.args, {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc.on('error', (err) => this.emit('error', err));
    this.proc.on('exit', (code, sig) => {
      for (const { reject } of this.pending.values()) reject(new Error(`ACP agent exited (${code ?? sig})`));
      this.pending.clear();
      this.emit('exit', code, sig);
    });
    this.proc.stderr.on('data', (d) => this.emit('stderr', d.toString()));
    const rl = createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => this.#onLine(line));
    return this;
  }

  stop() {
    try { this.proc?.stdin.end(); } catch {}
    try { this.proc?.kill('SIGTERM'); } catch {}
  }

  #send(msg) {
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.#send({ jsonrpc: '2.0', id, method, params });
    });
  }

  notify(method, params) {
    this.#send({ jsonrpc: '2.0', method, params });
  }

  #reply(id, result) { this.#send({ jsonrpc: '2.0', id, result }); }
  #replyError(id, code, message) { this.#send({ jsonrpc: '2.0', id, error: { code, message } }); }

  async #onLine(line) {
    line = line.trim();
    if (!line) return;
    let msg;
    try { msg = JSON.parse(line); } catch { this.emit('stderr', `non-JSON from agent: ${line}\n`); return; }

    // Response to one of our requests
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined) && !msg.method) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(Object.assign(new Error(msg.error.message || 'ACP error'), { code: msg.error.code, data: msg.error.data }));
      else p.resolve(msg.result);
      return;
    }

    // Agent -> client notification
    if (msg.method && msg.id === undefined) {
      if (msg.method === 'session/update') this.emit('update', msg.params);
      else this.emit('notification', msg.method, msg.params); // unknown ext notifications are ignored by default
      return;
    }

    // Agent -> client request
    if (msg.method && msg.id !== undefined) {
      try {
        if (msg.method === 'session/request_permission') {
          const outcome = this.onPermission
            ? await this.onPermission(msg.params)
            : { outcome: { outcome: 'cancelled' } };
          this.#reply(msg.id, outcome);
        } else {
          // Per Kiro guidance: explicit JSON-RPC error for unsupported agent->client requests.
          this.#replyError(msg.id, -32601, `Method not supported by Vocalo: ${msg.method}`);
        }
      } catch (err) {
        this.#replyError(msg.id, -32603, String(err?.message || err));
      }
    }
  }

  async initialize() {
    const res = await this.request('initialize', {
      protocolVersion: 1,
      // Vocalo is a voice client: it does not expose fs/terminal to the agent.
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: 'vocalo', title: 'Vocalo', version: '0.1.0' },
    });
    this.capabilities = res?.agentCapabilities ?? {};
    this.agentInfo = res?.agentInfo;
    return res;
  }

  /** Kiro advertises optional extension methods here; everything else must be gated on it. */
  get extensionMethods() {
    return this.capabilities?._meta?.kiro?.extensionMethods ?? [];
  }

  async newSession({ cwd = this.cwd, mcpServers = [], meta } = {}) {
    const params = { cwd, mcpServers };
    if (meta) params._meta = meta;
    const res = await this.request('session/new', params);
    this.sessionId = res.sessionId;
    this.session = res;
    return res;
  }

  /** Kiro V3: model/effort via session/set_config_option. Fails soft on other agents. */
  async setConfigOption(configId, value) {
    try {
      return await this.request('session/set_config_option', { sessionId: this.sessionId, configId, value });
    } catch (err) {
      this.emit('stderr', `set_config_option(${configId}) not applied: ${err.message}\n`);
      return null;
    }
  }

  /** Resolves when the turn ends (stopReason). Streaming arrives via 'update' events. */
  prompt(text) {
    return this.request('session/prompt', {
      sessionId: this.sessionId,
      prompt: [{ type: 'text', text }],
    });
  }

  cancel() {
    if (this.sessionId) this.notify('session/cancel', { sessionId: this.sessionId });
  }
}
