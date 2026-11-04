#!/usr/bin/env node
// Vocalo — voice-first, TV-style shell for ACP agents (Kiro CLI V3 by default).
// Speech always runs on this Mac; the agent runs here or on a remote machine over SSH.
import { readFileSync, existsSync, appendFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { execFile } from 'node:child_process';
import { AcpClient } from './acp/client.js';
import { Transport, parseRemoteSpec } from './acp/transport.js';
import { SpeechSidecar, SilentSpeech } from './speech/sidecar.js';
import { Orchestrator } from './core/orchestrator.js';
import { Controller } from './core/controller.js';
import { TvUI } from './ui/tui.js';
import { startEventServer } from './ui/events.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { values: argv } = parseArgs({
  options: {
    config: { type: 'string', default: resolve(ROOT, 'vocalo.config.json') },
    agent: { type: 'string' },              // "kiro-cli acp --agent-engine=v3" | "node test/mock-agent.js"
    remote: { type: 'string' },             // "user@devbox:/home/me/project"
    cwd: { type: 'string' },
    resume: { type: 'string' },             // "last" | session id
    'no-speech': { type: 'boolean', default: false },
    'spawn-sidecar': { type: 'boolean' },
    aspect: { type: 'string' },
    mode: { type: 'string' },               // vad | ptt
    permissions: { type: 'string' },        // ask | allow | deny
    busy: { type: 'string' },               // steer | interrupt | queue
    model: { type: 'string' },
    effort: { type: 'string' },
    log: { type: 'string' },
    metrics: { type: 'string' },
    'list-models': { type: 'boolean', default: false },
    doctor: { type: 'boolean', default: false },
  },
});

// ---------------------------------------------------------------- config
const defaults = {
  agent: { command: 'kiro-cli', args: ['acp', '--agent-engine=v3'], model: null, effortLevel: null, mode: null, additionalDirectories: [] },
  remote: null, // { host, port, identityFile, sshOptions: [], env: {}, cwd, command }
  cwd: process.cwd(),
  speech: { url: 'ws://127.0.0.1:8765', spawn: true, python: resolve(ROOT, 'sidecar/.venv/bin/python') },
  ui: { aspect: '16:9', eventsPort: 8766 },
  conversation: { mode: 'vad', bargeIn: true, permissions: 'ask', preamble: true, defaultLang: 'en', busyPolicy: 'steer' },
  control: { autoCompactAt: 85, speakConfirmations: false },
};
const fileCfg = existsSync(argv.config) ? JSON.parse(readFileSync(argv.config, 'utf8')) : {};
const merge = (k) => ({ ...defaults[k], ...fileCfg[k] });
const cfg = { ...defaults, ...fileCfg, agent: merge('agent'), speech: merge('speech'), ui: merge('ui'), conversation: merge('conversation'), control: merge('control') };
if (argv.agent) { const [c, ...a] = argv.agent.split(' ').filter(Boolean); cfg.agent.command = c; cfg.agent.args = a; }
if (argv.remote) { const r = parseRemoteSpec(argv.remote); cfg.remote = { ...(cfg.remote ?? {}), host: r.host }; if (r.cwd) cfg.cwd = r.cwd; }
if (cfg.remote?.cwd && !argv.remote && !argv.cwd) cfg.cwd = cfg.remote.cwd;
if (cfg.remote?.command) cfg.agent.command = cfg.remote.command;
if (argv.cwd) cfg.cwd = argv.cwd;
if (argv.aspect) cfg.ui.aspect = argv.aspect;
if (argv.mode) cfg.conversation.mode = argv.mode;
if (argv.permissions) cfg.conversation.permissions = argv.permissions;
if (argv.busy) cfg.conversation.busyPolicy = argv.busy;
if (argv.model) cfg.agent.model = argv.model;
if (argv.effort) cfg.agent.effortLevel = argv.effort;
if (argv['spawn-sidecar'] !== undefined) cfg.speech.spawn = argv['spawn-sidecar'];
if (cfg.remote && cfg.cwd === process.cwd() && !argv.cwd) cfg.cwd = null; // remote default: login dir

const logFile = argv.log;
const metricsFile = argv.metrics ?? fileCfg.metricsFile;
const log = (...a) => { if (logFile) appendFileSync(logFile, `[${new Date().toISOString()}] ${a.join(' ')}\n`); };

const transport = new Transport({ command: cfg.agent.command, args: cfg.agent.args, cwd: cfg.cwd, remote: cfg.remote });

// ---------------------------------------------------------------- doctor
if (argv.doctor) {
  console.log(`Vocalo doctor — agent at ${transport.label}\n`);
  for (const r of await transport.doctor()) console.log(`${r.ok ? '✔' : '✘'} ${r.name.padEnd(30)} ${String(r.ms).padStart(5)} ms  ${r.info ?? ''}`);
  const acp = new AcpClient({ transport }).start();
  try {
    const t = Date.now();
    const init = await acp.initialize();
    console.log(`✔ ${'ACP initialize'.padEnd(30)} ${String(Date.now() - t).padStart(5)} ms  ${init.agentInfo?.name ?? ''} ${init.agentInfo?.version ?? ''}`);
    console.log(`  extensions: ${acp.extensionMethods.join(', ') || '(none advertised)'}`);
    const t2 = Date.now();
    await acp.newSession({ cwd: cfg.cwd ?? undefined, mcpServers: [] });
    console.log(`✔ ${'ACP session/new'.padEnd(30)} ${String(Date.now() - t2).padStart(5)} ms`);
    for (const o of acp.configOptions) console.log(`  ${(o.configId ?? o.id).padEnd(12)} = ${o.currentValue}   [${(o.options ?? []).map((v) => v.value).join(', ')}]`);
  } catch (e) { console.log(`✘ ACP handshake failed: ${e.message}`); }
  acp.stop();
  process.exit(0);
}

// ---------------------------------------------------------------- wiring
const ui = new TvUI({ aspect: cfg.ui.aspect, readFile: (p) => transport.readFile(p) });
const events = startEventServer({ port: cfg.ui.eventsPort, onCommand: (c) => handleCommand(c) });

const openUrlOnMac = (url) => new Promise((res) => {
  if (!/^https:\/\//.test(url || '')) return res(false);
  execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], (err) => res(!err));
});
let urlWaiter = null;
const acp = new AcpClient({
  transport,
  // Kiro asks the client to open sign-in pages; in remote mode that browser is the Mac's.
  // Kiro requires a visible user action, so we wait for the [o] key instead of auto-opening.
  onOpenUrl: (url) => new Promise((resolveOpen) => {
    urlWaiter = async () => resolveOpen(await openUrlOnMac(url));
    ui.set({ pendingUrl: true });
    setTimeout(() => { if (urlWaiter) { urlWaiter = null; ui.set({ pendingUrl: null }); resolveOpen(false); } }, 5 * 60000);
  }),
});
acp.on('stderr', (s) => log('agent:', s.trim()));

const speech = argv['no-speech']
  ? new SilentSpeech()
  : new SpeechSidecar({
      url: cfg.speech.url,
      cwd: resolve(ROOT, 'sidecar'),
      spawnCmd: cfg.speech.spawn ? [existsSync(cfg.speech.python) ? cfg.speech.python : 'python3', '-m', 'vocalo_speech.server'] : null,
    });
speech.on('log', (m) => log('speech:', m.message));
speech.on('error', (m) => { log('speech error:', m.message); ui.set({ notice: m.message }); });

const orch = new Orchestrator({ acp, speech, config: cfg.conversation });
const ctl = new Controller({ acp, orch, transport, ui, config: cfg.control });

// ---- orchestrator/controller -> UI + event stream
let mode = cfg.conversation.mode, muted = false, pttActive = false;
const pub = (type, payload) => events.publish(type, payload);
orch.on('state', (st) => { ui.set({ state: st, ...(st === 'idle' ? { tool: '' } : {}) }); pub('state', { state: st }); });
orch.on('user_partial', (text) => { ui.set({ userPartial: text }); pub('user_partial', { text }); });
orch.on('user_final', (text) => { ui.set({ user: text, userPartial: '' }); pub('user', { text }); log('user:', text); });
orch.on('assistant_subtitle', ({ text, durationMs }) => { ui.subtitle(text, durationMs); pub('subtitle', { text, durationMs }); });
orch.on('assistant_stream', (text) => pub('assistant_stream', { text }));
orch.on('scene', (tag) => { ui.scene(tag); pub('scene', tag); });
orch.on('code', (code) => { ui.set({ code, image: null, diff: null }); pub('code', { code }); });
orch.on('plan', (entries) => { ui.plan(entries); pub('plan', { entries }); });
orch.on('diff', (d) => { ui.showDiff(d); pub('diff', d); });
orch.on('steered', (text) => { ui.set({ notice: `↪ steered: ${text}` }); pub('steered', { text }); });
orch.on('queued', (text) => { ui.set({ notice: `⏳ queued: ${text}` }); pub('queued', { text }); });
const toolTitles = new Map();
orch.on('tool', (t) => {
  if (t.title) toolTitles.set(t.id, t.title);
  const title = t.title ?? toolTitles.get(t.id);
  if (title) ui.set({ tool: t.status === 'completed' ? '' : `${title}${t.status ? ' · ' + t.status.replace('_', ' ') : ''}` });
  pub('tool', { ...t, title });
});
orch.on('metrics', (m) => {
  ui.set({ metrics: m }); pub('metrics', m); log('metrics', JSON.stringify(m));
  if (metricsFile && m.voiceToVoiceMs != null) appendFileSync(metricsFile, JSON.stringify({ t: new Date().toISOString(), where: transport.label, model: acp.current('model'), ...m }) + '\n');
});
orch.on('permission', ({ title, resource }) => { ui.set({ permission: resource ? `${title} (${resource})` : title }); pub('permission', { title, resource }); });
orch.on('permission_resolved', () => ui.set({ permission: null }));
orch.on('turn_end', ({ stopReason, text }) => log('assistant:', JSON.stringify(text), stopReason));
orch.on('warn', (w) => { ui.set({ notice: w }); log('warn', w); });

ctl.on('overlay', ({ title, lines }) => { ui.overlay(title, lines); pub('overlay', { title, lines }); });
ctl.on('info', (m) => ui.set({ notice: m }));
ctl.on('code', (code) => { ui.set({ code, image: null, diff: null }); pub('code', { code }); });
ctl.on('scene', (tag) => { ui.scene(tag); pub('scene', tag); });
ctl.on('diff', (d) => ui.showDiff(d));
ctl.on('toggle_plan', () => ui.set({ showPlan: !ui.s.showPlan }));
ctl.on('session_changed', () => { ui.plan([]); refreshAgentHeader(); });

function refreshAgentHeader() {
  const k = acp.kiro;
  const modeName = acp.current('mode') ?? k.modes?.currentModeId ?? null;
  const model = acp.option('model');
  const modelName = model ? (model.options?.find((v) => v.value === model.currentValue)?.name ?? model.currentValue) : null;
  ui.agentInfo({ where: transport.isRemote ? transport.label : 'local', model: modelName, mode: modeName, effort: acp.current('effortLevel'), contextPct: k.contextPct });
  pub('agent', { where: transport.label, model: modelName, mode: modeName, contextPct: k.contextPct, sessionId: acp.sessionId });
}
acp.on('session_state', refreshAgentHeader);

function permissionKey(choice) {
  const p = orch.pendingPermission; if (!p) return;
  const kinds = { allow: ['allow_once', 'allow_always'], always: ['allow_always', 'allow_once'], reject: ['reject_once', 'reject_always'] }[choice];
  const o = kinds.map((k) => p.options.find((x) => x.kind === k)).find(Boolean);
  orch.resolvePermission(o?.optionId ?? null);
}

function handleCommand(c) {
  if (c.type === 'text') orch.userSaid(c.text, {});
  else if (c.type === 'interrupt') orch.interrupt('user');
  else if (c.type === 'command') ctl.run(c.line);
  else if (c.type === 'permission') permissionKey(c.choice);
}

ui.on('text', (t) => (t.startsWith('/') || t.startsWith(':') ? ctl.run(t) : orch.userSaid(t, {})))
  .on('command', (line) => ctl.run(line))
  .on('interrupt', () => orch.interrupt('user'))
  .on('permission', permissionKey)
  .on('open_url', () => { const w = urlWaiter; urlWaiter = null; w?.(); })
  .on('mute', () => { muted = !muted; speech.mic(!muted); ui.set({ muted }); })
  .on('mode', () => { mode = mode === 'vad' ? 'ptt' : 'vad'; speech.mode(mode); ui.set({ mode }); })
  .on('ptt', () => {
    // Terminals have no key-up events, so PTT is tap-to-start / tap-to-send.
    if (mode !== 'ptt') { mode = 'ptt'; speech.mode('ptt'); ui.set({ mode }); }
    pttActive = !pttActive;
    if (pttActive && orch.state === 'speaking') orch.interrupt('ptt');
    speech.ptt(pttActive);
    ui.set({ notice: pttActive ? 'recording… tap space to send' : '' });
  })
  .on('quit', shutdown);

// ---- agent connection lifecycle (local crash or SSH drop): restart + re-attach
let shuttingDown = false, restarts = 0, lastRestart = 0;
async function connectAgent({ resume } = {}) {
  if (transport.isRemote && !cfg.cwd) { // no path given: use the remote login directory
    cfg.cwd = (await transport.exec('pwd')).trim();
    transport.cwd = acp.cwd = cfg.cwd;
  }
  acp.start();
  await acp.initialize();
  log('agent init', JSON.stringify({ agentInfo: acp.agentInfo, ext: acp.extensionMethods }));
  const kiroInit = Object.fromEntries(Object.entries({ modelId: cfg.agent.model, effortLevel: cfg.agent.effortLevel, modeId: cfg.agent.mode }).filter(([, v]) => v));
  const sessionOpts = { cwd: cfg.cwd ?? undefined, mcpServers: [], additionalDirectories: cfg.agent.additionalDirectories };
  let resumed = false;
  if (resume && acp.canLoadSession) {
    try {
      let id = resume;
      if (resume === 'last') id = (await acp.listSessions({ cwd: cfg.cwd ?? undefined }))[0]?.id;
      if (id) { await acp.loadSession({ ...sessionOpts, sessionId: id }); resumed = true; }
    } catch (e) { log('resume failed', e.message); ui.set({ notice: `resume failed: ${e.message}` }); }
  }
  if (!resumed) await acp.newSession({ ...sessionOpts, kiro: kiroInit });
  // Also apply via set_config_option: agents that ignore _meta.kiro still honour this.
  if (cfg.agent.model && acp.current('model') !== cfg.agent.model) await acp.setConfigOption('model', cfg.agent.model).catch((e) => log('model', e.message));
  if (cfg.agent.effortLevel && acp.option('effortLevel') && acp.current('effortLevel') !== cfg.agent.effortLevel)
    await acp.setConfigOption('effortLevel', cfg.agent.effortLevel).catch((e) => log('effort', e.message));
  if (cfg.agent.mode && !resumed) await acp.setMode(cfg.agent.mode).catch((e) => log('mode', e.message));
  refreshAgentHeader();
  return resumed;
}

acp.on('exit', async (code) => {
  if (shuttingDown) return;
  orch.interrupt('agent-exit').catch(() => {});
  if (Date.now() - lastRestart > 120000) restarts = 0;
  if (++restarts > 6) return ui.set({ notice: `agent connection lost (${code}); press q and check \`vocalo --doctor\`` });
  lastRestart = Date.now();
  ui.set({ notice: `${transport.isRemote ? 'SSH/agent' : 'agent'} disconnected (${code}) — reconnecting…` });
  await new Promise((r) => setTimeout(r, Math.min(8000, 700 * restarts)));
  const prev = acp.sessionId;
  try {
    await connectAgent({ resume: prev });
    ui.set({ notice: `reconnected${acp.sessionId === prev ? ' · same session' : ''}` });
  } catch (err) { ui.set({ notice: `reconnect failed: ${err.message}` }); log('reconnect failed', err.stack); }
});

function shutdown() {
  shuttingDown = true;
  ui.stop(); speech.close(); acp.stop(); events.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('uncaughtException', (e) => { log('fatal', e.stack); ui.stop(); console.error(e); process.exit(1); });

// ---------------------------------------------------------------- boot
if (argv['list-models']) {
  await connectAgent();
  console.log(`Agent: ${acp.agentInfo?.name ?? '?'} ${acp.agentInfo?.version ?? ''} at ${transport.label}`);
  for (const o of acp.configOptions) {
    console.log(`\n${o.name ?? o.configId ?? o.id} (${o.configId ?? o.id}) = ${o.currentValue}`);
    for (const v of o.options ?? []) console.log(`  ${v.value === o.currentValue ? '▶' : ' '} ${v.value}${v.name ? `  ${v.name}` : ''}${v.description ? `  — ${v.description}` : ''}`);
  }
  if (acp.kiro.modes) console.log('\nmodes:', acp.kiro.modes.availableModes?.map((m) => m.id).join(', '));
  acp.stop(); events.close(); process.exit(0);
}

ui.start();
ui.set({ title: 'Vocalo', caption: transport.isRemote ? `connecting to ${transport.remote.host}…` : 'warming up voice + agent…', mode });
try {
  const sp = speech.start();
  if (transport.isRemote) {
    const ms = await transport.warm();
    ui.set({ caption: `ssh ${transport.remote.host} ${ms} ms · starting agent…` });
  }
  const resumed = await connectAgent({ resume: argv.resume });
  ui.set({ caption: 'agent ready · loading speech models (first run downloads them)…' });
  await sp;
  speech.mode(mode);
  const name = acp.agentInfo?.title || acp.agentInfo?.name || cfg.agent.command;
  ui.set({ caption: `${name}${transport.isRemote ? ' @ ' + transport.label : ''}${resumed ? ' · resumed' : ''} · say hi${mode === 'ptt' ? ' (space to talk)' : ''}` });
} catch (err) {
  ui.set({ notice: `startup failed: ${err.message}` });
  log('startup failed', err.stack);
}
