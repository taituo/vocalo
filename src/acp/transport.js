// Where the agent runs. Local: spawn kiro-cli. Remote: the same ACP stdio stream
// tunnelled over SSH. Speech stays on the Mac; files, edits, git, tests and Kiro
// sessions all stay on the remote machine.
//
//   MacBook (mic, speakers, TUI, Vocalo)  ──ssh -T──►  dev box: kiro-cli acp --agent-engine=v3
//
// One multiplexed SSH connection (ControlMaster) carries the ACP stream AND quick
// side-channel reads (images, screenshots, files), so those cost ~1 RTT, not a new handshake.
import { spawn, execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** POSIX single-quote escaping for the remote shell. */
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** "user@host:/path" | "host" -> { host, cwd } */
export function parseRemoteSpec(spec) {
  const m = /^([^:]+?)(?::(.+))?$/.exec(spec || '');
  if (!m) throw new Error(`bad --remote spec: ${spec}`);
  return { host: m[1], cwd: m[2] };
}

export class Transport {
  /**
   * @param {object} cfg
   * @param {string} cfg.command  agent executable (local) or path on the remote
   * @param {string[]} cfg.args
   * @param {string} cfg.cwd      working dir (remote path when remote)
   * @param {object} [cfg.remote] { host, port, identityFile, sshOptions[], env{}, shell }
   */
  constructor({ command, args = [], cwd, remote = null, env = {} }) {
    Object.assign(this, { command, args, cwd, remote, env });
    if (remote) {
      this.controlPath = remote.controlPath || join(homedir(), '.ssh', 'vocalo-%C');
    }
  }

  get isRemote() { return !!this.remote; }
  get label() { return this.isRemote ? `${this.remote.host}:${this.cwd ?? '~'}` : 'local'; }

  sshBase() {
    const r = this.remote;
    const o = [
      '-o', 'ControlMaster=auto', '-o', `ControlPath=${this.controlPath}`, '-o', 'ControlPersist=10m',
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      '-o', 'BatchMode=yes', // never hang on a password prompt: keys/agent only
    ];
    if (r.port) o.push('-p', String(r.port));
    if (r.identityFile) o.push('-i', r.identityFile);
    for (const x of r.sshOptions ?? []) o.push(...(Array.isArray(x) ? x : ['-o', x]));
    return o;
  }

  /** Command run on the remote: login shell so ~/.local/bin etc. are on PATH. */
  remoteCommand(cmdline, { replace = true } = {}) {
    const envs = Object.entries(this.remote.env ?? {}).map(([k, v]) => `${k}=${shq(v)}`).join(' ');
    const cd = this.cwd ? `cd ${shq(this.cwd)} && ` : '';
    const shell = this.remote.shell || 'bash -lc';
    // `exec` only for the long-lived agent (signals reach it directly); helpers may be compound commands
    return `${shell} ${shq(`${cd}${envs ? (replace ? envs + ' ' : `export ${envs}; `) : ''}${replace ? 'exec ' : ''}${cmdline}`)}`;
  }

  /** argv for spawning the agent */
  agentArgv() {
    if (!this.isRemote) return [this.command, this.args];
    const cmdline = [this.command, ...this.args].map(shq).join(' ');
    return ['ssh', ['-T', ...this.sshBase(), this.remote.host, '--', this.remoteCommand(cmdline)]];
  }

  spawnAgent() {
    const [cmd, argv] = this.agentArgv();
    return spawn(cmd, argv, {
      cwd: this.isRemote ? undefined : this.cwd,
      env: { ...process.env, ...(this.isRemote ? {} : this.env) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  /** Run a short command on the agent's machine (remote via the shared connection). */
  exec(cmdline, { timeoutMs = 15000, encoding = 'utf8', maxBuffer = 64 << 20 } = {}) {
    return new Promise((resolve, reject) => {
      const [cmd, argv] = this.isRemote
        ? ['ssh', ['-T', ...this.sshBase(), this.remote.host, '--', this.remoteCommand(cmdline, { replace: false })]]
        : ['bash', ['-lc', `${this.cwd ? `cd ${shq(this.cwd)} && ` : ''}${cmdline}`]];
      execFile(cmd, argv, { timeout: timeoutMs, encoding, maxBuffer }, (err, stdout, stderr) =>
        err ? reject(Object.assign(err, { stderr: String(stderr) })) : resolve(stdout));
    });
  }

  /**
   * Read a file from where the AGENT lives. In remote mode an absolute path means the
   * remote path; prefix with "mac:" to read a file on this Mac instead.
   */
  async readFile(path) {
    if (path.startsWith('mac:')) return readFile(path.slice(4));
    if (!this.isRemote) return readFile(path.startsWith('/') || !this.cwd ? path : join(this.cwd, path));
    const out = await this.exec(`cat -- ${shq(path)}`, { encoding: 'buffer' });
    return Buffer.isBuffer(out) ? out : Buffer.from(out);
  }

  /** Warm the multiplexed connection so the first ACP byte isn't waiting on an SSH handshake. */
  async warm() {
    if (!this.isRemote) return 0;
    const t = Date.now();
    await this.exec('true', { timeoutMs: 20000 });
    return Date.now() - t;
  }

  /** Health check used by `vocalo --doctor`. */
  async doctor() {
    const report = [];
    const step = async (name, fn) => {
      const t = Date.now();
      try { const v = await fn(); report.push({ name, ok: true, ms: Date.now() - t, info: v }); }
      catch (e) { report.push({ name, ok: false, ms: Date.now() - t, info: (e.stderr || '').trim().slice(0, 300) || (e.killed ? 'timed out' : `exit ${e.code ?? '?'}`) }); }
    };
    if (this.isRemote) {
      await step('ssh connect (key auth)', () => this.warm().then((ms) => `${ms} ms`));
      await step('ssh round-trip (multiplexed)', async () => {
        const t = Date.now(); await this.exec('true'); return `${Date.now() - t} ms`;
      });
    }
    await step('working directory', () => this.exec('pwd').then((s) => s.trim()));
    await step('agent binary', () => this.exec(`command -v ${shq(this.command)} || ls -l ${shq(this.command)}`).then((s) => s.trim()));
    await step('agent version', () => this.exec(`${shq(this.command)} --version`).then((s) => s.trim()));
    await step('kiro steering for Vocalo', () => this.exec('ls .kiro/steering/vocalo.md 2>/dev/null || ls ~/.kiro/steering/vocalo.md 2>/dev/null || { echo "missing: copy steering/vocalo.md to .kiro/steering/" >&2; exit 1; }')
      .then((s) => s.trim()));
    return report;
  }
}
